# AI Workspace

AI workspace desktop app. Tauri 2 + Rust + React 19 + TypeScript.

## Status (2026-05-27)

| Phase | State | Outcome |
|-------|-------|---------|
| 0 — Hardening | ✅ shipped | Open existing workspaces safely. Frontmatter byte-identical round-trip. Multi-workspace registry. ko/en parity. |
| 0.5 — UI polish | ✅ shipped | Topbar, sidebar with type filters + recents, command palette (⌘K), Pretendard Korean typography, light/dark. |
| 1A — Killer feature MVP | ✅ shipped | Doc-selection reliability, frontmatter inline edit (InspectorPane), wikilink autocomplete (Korean IME-aware) + click-to-navigate, typed neighborhood pane (project / mentions / peers), in-memory nav history (⌘[ / ⌘]). |
| 1B — Rich editor / git | ✅ feature-complete | Git status badge + commit-from-app (file list + per-file diff + syntax color + auto-refresh on focus). Workspace scan rayon parallelism plus cache-backed warm startup for `~/workspace/work`: cached entries + active document render first, then authoritative scan reconciles in the background. Multi-tab editor (per-workspace persistence, ⌘1..⌘8 select, ⌘W close, dirty stash). BlockNote rich + source + preview 3-way toggle (frontmatter line preserved). Browser smoke e2e is in place. **Deferred**: monorepo extraction. |
| 2 — Inbox + AI | ✅ write loop live | Backend (polling, watcher, date parser, Claude CLI bridge, classifier, Gmail via `gws` CLI) + UI (`InboxPane` with Configured Entries / Processing / Processed Items / Files / Gmail sections, classify/accept/reject/process) all shipped. The primary local inbox flow now reads `workspace.config.yaml` `inbox:` settings, stages dropped files into the configured `inbox.file_drop` channel/path, scans `inbox/drop/<channel>/` plus `items/pending/*/manifest.yaml`, and reads processed history from `items/{done,failed,duplicate}` using configured artifact filenames; legacy `inbox/downloads/<source>` remains compatible. Accept/reject runs through an approval gate, Gmail decisions apply Anchor labels, keyboard `a`/`r`/`p`, multi-select, bulk actions, dot folders are hidden unless allowlisted in Settings, and mission state/log/stop hooks are in place. |
| 2.5 — Tree + Cursor shell + Terminal launchers | ✅ shipped | The Explorer pane now switches between Documents and Files. Documents keeps list/tree mode, type filters, filename/title labels, default-collapsed folders with persisted user-expanded folders, and Reveal in Finder. Files adds a VS Code-style workspace tree with workspace-safe scanning, All/Git tracked/Binary filters, search, multi-select, and add-to-queue actions; Binary is driven by configurable include patterns for artifact file types. The right Files pane is an explicit copy/move queue with destination selection, conflict-safe naming, Apply/Clear, and workspace capability gates. The shell now uses a Cursor-style activity rail, grouped Private/Public workspace switcher, split-right document and terminal panes (`⌘D`), clean-tab close-all, a right-edge utility rail, and bottom integrated terminal with maximize/restore. `~/.anchor/settings.json` stores user/global theme/accent/layout/window/split/terminal defaults, Explorer display defaults, file-queue defaults, and future AI defaults; `<workspace>/.anchor/workspace-state.json` stores workspace-only UI state and overrides. Claude, Codex, and Shell launch as real PTY tabs rendered by the Rust-native terminal model and React grid; first run starts with the terminal collapsed and restores the user's last layout afterward. Signed auto-update checks run at startup, and the native app menu exposes standard File/Edit/View/Go/Terminal/Workspace/Help commands. |
| 3 — Unified document operations (7 modules) | ✅ W1-W6 + skills SSOT hardening | 사업단/대학본부조직 document operations 7-module 로드맵 (M1 Operations Catalog · M2 Document Studio · M3 Template/Form Filling · M4 Export Pipeline · M5 Evidence Binder · M6 Deck Studio · M7 Hub Connector). **W1**: rule SSOTs (frontmatter-schema, bu-lifecycle, hub-sync, evidence-policy) + Rust `ops_catalog` + `hub_client` scaffolds + 4 BU seeds. **W2 (anchor-hub)**: 9 catalog REST endpoints + Alembic 0001_core schema (13 tables) + 21-template synthetic seed + 12 pytest. **W3**: real `ops_catalog::scan` indexing across BU configs / inbox manifests / tasks frontmatter / document frontmatter / evidence sidecars; `Catalog` mode + 3-column UI. **W4**: notify-based fs watcher with debounced `catalog://refresh`, real Hub HTTP read path (reqwest blocking + ETag + offline fallback), Catalog drilldown dialog + Reveal-in-Finder, verification gate (110 entries / 4 BUs / 986 ms on `~/workspace/work`). **W5**: `hubLibrary` typed fetchers + NewDocumentDialog Hub template/guideline pickers + CommandPalette "Hub 템플릿으로 새 문서" + Catalog open. **W6**: WritingGuidelineSidebar (right-pane tab, resolves frontmatter `guideline_ids` and `anchor:guidelines` provenance trailer, multi-tab body viewer). **Skills SSOT**: Rust `skill_host` owns tiers (`core/public/private/imported/managed`), doctor validation, dirty/reconcile, and explicit external import/unmanage; bundled skills are normalized to `core`; invalid duplicate/misplaced records cannot install or dispatch. Test totals: cargo 381 / 2 ignored + vitest/typecheck path green on the current branch. |
| 4 — Document Edit Mode (Studio + Templates) | ✅ W7-W12 done | Folds anchor-editor into a 7-step Document Studio (source → template → guideline → sections → HWP fields → export → package) backed by M3 + M4. **W7**: `create_document` accepts `CreateDocumentExtras` and emits template/guideline/BU metadata as proper frontmatter. **W8-W10**: `src-tauri/src/export/` plans, validates, records transitions, and dispatches docx/hwpx/pdf bundles through the manifest lifecycle. **W11 (M2 Studio)**: new `Studio` activity-rail mode persists per-document state under `<workspace>/.anchor/studio/<doc-id>/state.json`, reuses Hub template/guideline pickers, edits section drafts, dispatches exports, and freezes local version snapshots. **W12 (M3 + M2 lint)**: `hwpx slots` + `template_get_fields/template_fill_hwpx` expose real HWPX field maps in Studio Step 5; `kordoc_lite` adds HWPX structure checks, Korean public-form label detection, preserved form fill, and format-specific export checks; Step 4 runs debounced 개조식 lint with CodeMirror decorations, BlockNote marks, and workspace-state `composer.lintDismissals`. Latest verification: `pnpm typecheck`, targeted `cargo test --lib` filters (`kordoc_lite`, `template_fill`, `validate`), `hwpx slots` against bundled `사업계획서_기본.hwpx`. |
| 5 — Evidence Binder + Deck Studio | 🚧 W13 shipped | Evidence Binder is now a right-pane tab keyed by the active document id. It persists state under `<workspace>/.anchor/binder/<doc-id>.json`, seeds candidates from inbox-processed raw files and `<binary>.evidence.yaml` sidecars, scopes sidecar discovery to the active BU when possible, and uses `kordoc_lite` for local format detection, lightweight structure checks, and HWPX field previews. W14-W18 remain planned for section/KPI/checklist bindings and Deck Studio. |
| D — Concept-map Diagram mode | ✅ shipped (Phase 0–7, hardened) | New top-level `diagram` mode in the activity rail and command palette (`Network` icon, enabled by default — opt out via Settings → Preferences). HWP-style 9-tab ribbon, 13 node kinds (simple / text / numbered / section / titled-box / split-box / diamond / oval / hexagon / cylinder / callout / table / image), 4-port edges with auto/straight routing + arrowheads + labels, smart-guide snap, align/distribute/equalize selection ops, drag-reorder layer panel, per-selection property editor, color presets, focus mode, find/replace, Tools/Infographic/Arrow/Table ribbon controls, memos + status chips + progress bars, 11 localized templates, PNG/PNG-transparent/JPG/SVG/JSON/PDF/Mermaid export via selected-path Tauri save dialog, Mermaid import, version history with 5-min auto-snapshots (cap 20 per doc), workspace-keyed unsaved state + persisted `diagram.lastDocument`, Radix confirmation dialogs, lock/hide enforcement, and viewport culling + edge-route cache for 1000-node smoothness. Documents live at `<workspace>/diagrams/<name>.cmd.json` (v:7). Latest gate: `pnpm typecheck`, `pnpm test`, `pnpm build`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, diagram bench, `pnpm test:e2e`. |

Plan reference (work repo internal): `~/.claude/plans/flickering-seeking-engelbart.md`. Rule SSOTs at `~/workspace/work/_sys/rules/{frontmatter-schema,bu-lifecycle,hub-sync,evidence-policy}.md`.

## Install

Anchor ships the desktop app and CLI as separate artifacts. On macOS, both are
distributed through the `STAIxBWLB/homebrew-cask` tap:

```bash
brew tap STAIxBWLB/homebrew-cask

# Desktop app only:
brew install --cask anchor-workspace

# Standalone CLI only. Installs the executable as `anchor`:
brew install anchor-cli

anchor --version
```

The app cask installs `Anchor.app` and does not create a CLI symlink. The CLI
formula installs only the standalone `anchor` executable. The desktop app keeps
using signed Tauri updater metadata from GitHub Releases; Homebrew users can
also upgrade via `brew upgrade --cask anchor-workspace` and `brew upgrade anchor-cli`.

For repo-local management shortcuts:

```bash
make cli-install
make cli-smoke
make release-preflight
make homebrew-update RELEASE_TAG=v0.2.12 HOMEBREW_TAP_DIR=../homebrew-cask
```

## Phase 3 verification gates (passed)

1. **Catalog watcher + auto-refresh** — notify recursively watches `inbox/items/`, `tasks/{active,calendar}`, every BU's `02-admin-approvals/` + `03-evidence-cert/` + `.anchor/bu-config.yaml`; bursts are debounced 500 ms and the React pane re-queries in another 300 ms.
2. **Hub catalog read path** — `hub_client::http::fetch_with_cache` GETs `/api/v1/{templates,guidelines,glossary,...}` with ETag revalidation, falls back to `<workspace>/.anchor/cache/hub/` on any network error.
3. **Drilldown dialog + Reveal** — Catalog row → modal showing frontmatter + manifest + README excerpt + sibling paths + "Finder에서 보기".
4. **Real-workspace timing** — `ANCHOR_CATALOG_BENCH_WORKSPACE=~/workspace/work cargo test --lib -- --ignored catalog_real_workspace_smoke` indexed 110 entries across 4 BUs in 986 ms (30× under the 30-second budget).
5. **Template-aware new doc** — `⌘ ⇧ N` / palette "Hub 템플릿으로 새 문서" → BU/category filter → template picker prefills body + title + docType → optional guideline multi-select → `anchor:template` / `anchor:business_unit` / `anchor:guidelines` provenance trailer in body.
6. **Guideline sidebar** — opening a doc created via the template flow surfaces its guideline bodies in the right-pane `BookOpen` tab.

### Live-Hub verification (operator procedure)

The above gates run fully offline (cache fallback). To exercise the live Hub read path:

```bash
# anchor-hub: start FastAPI + sqlite (or run docker compose up -d db for Postgres)
cd dev/anchor-hub
uv run python -m scripts.seed_catalog
ANCHOR_HUB_DATABASE_URL=sqlite:///tmp/anchor-hub.db uv run uvicorn anchor_hub.main:app --port 8017

# anchor: flip workspace.config.yaml
#   hub.enabled: true
#   hub.endpoint: http://127.0.0.1:8017/api/v1
#   hub.api_token_ref: ~/workspace/work/.secrets/hub-token (empty file is fine for local)
```

Then in Anchor: open Catalog mode → footer "마지막 스캔" populates; ⌘ ⇧ N → toggle "Hub 템플릿에서 시작" → templates load from Hub; pick `business-plan-default` → body prefills with slot hints.

After Phase 6 W21 ships, the same operator procedure will also exercise the `POST /api/v1/documents/{id}/finalize` round-trip — Anchor pushes the approved markdown body + rendered artifacts + linked evidence binaries to Hub, and the document then appears under the Hub Finalized tab inside Catalog mode.

## Next up (Phase 5 W14)

1. **Evidence-to-section binding model** — prepare the W14 frontmatter shape for section/KPI/submission-checklist bindings without moving binaries to Hub.
2. **Evidence verification controls** — add Verify / Mark-as-submitted controls on top of the W13 Binder state.
3. **Export dispatch hardening** — optional: move long-running converters behind background mission state; W12 already adds lightweight docx/hwpx/pdf structure checks without changing the manifest lifecycle.
4. **Hub metadata sync caller** — planned M7 follow-up for `POST /api/v1/documents/sync`; Studio package remains local-only until the Phase 6 approval/finalize path.

## Hub as published-document SSOT (local Studio + Phase 6 W21)

Anchor stays the **author SSOT** — drafting and editing always happen under `~/workspace/work/`. Anchor Hub becomes the **published SSOT** the moment an approval route closes.

Two write paths land on Hub from Anchor:

1. **`POST /api/v1/documents/sync`** (planned M7 follow-up) — drafting metadata only. Anchor sends `document_uri`, `body_sha256`, `frontmatter`, and the evidence link graph. **No body, no binary.** Used for cross-BU lookups and to surface "이미 동기화된 초안" hints.
2. **`POST /api/v1/documents/{id}/finalize`** (Phase 6 W21) — approval-gated canonical push. The instant `submission_gate.state` flips to `approved`, Anchor auto-calls finalize with the full markdown body, every rendered artifact in the M4 manifest (docx/hwpx/pdf), and the binary bytes of every evidence file linked via `frontmatter.evidence_links`. On `201`, the local frontmatter `status` flips to `archived-hub:<finalized_id>@v<N>` and any subsequent edit creates a new draft that, once re-approved, becomes version `N+1` on Hub.

W12 leaves Studio package freeze local-only. Phase 6 W21 must add the matching `hub_client/safety.rs` pre-flight so `/documents/{id}/finalize` is the only Anchor client path allowed to carry body/binary payloads, and only after the corresponding submission gate is approved.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri Webview (src/)                                        │
│   React 19 + Radix UI + marked (preview) + DOMPurify         │
│   Phase 1B: + BlockNote rich editor + MediaPipe (Phase 4)    │
│                                                               │
│   Activity rail: Docs / Inbox / Settings                     │
│   Documents/Files Explorer + editor + queue + terminal        │
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri IPC
┌──────────────────────────────▼──────────────────────────────┐
│  Rust core (src-tauri/src/)                                  │
│   workspace scan — walkdir + .anchorignore + cached index           │
│   frontmatter/   — line-by-line YAML edit (preserves order)  │
│   document.rs    — read/save/create/version + field patch    │
│   git.rs         — status/commit/diff via shell-out          │
│   vault_list.rs  — workspace registry + private/public active roots │
│   filename_rules.rs — Korean NFC/NFD safety, Windows reserve │
│                                                               │
│   inbox.rs / inbox_watcher.rs / korean_date.rs               │
│   inbox_classifier.rs / gmail_gws.rs / ai_router.rs / terminal.rs │
│   anchor_dir.rs  — layered settings + .anchor rules/templates/catalogs │
│   Phase 3+: + skill_host/ registry + standalone CLI dispatch │
│   Phase 4+: + whisper bridge / mcp lifecycle                 │
└──────┬─────────────────────────────────────────────────────┘
       │ stdio bridge + future WS/MCP bridges
┌──────▼────────┐ ┌────────────────────┐ ┌──────────────────┐
│ MCP server    │ │ User's Claude Code │ │ Whisper sidecar  │
│ (Node, Phase 3)│ │ CLI (~/.claude/skills/*)│ │ (Python, Phase 4)│
└───────────────┘ └────────────────────┘ └──────────────────┘
```

**Module boundary rules**:
- Rust core **owns** workspace FS / cache / git / frontmatter / inbox scan/watch/classification / Gmail `gws` bridge / layered Anchor settings (`~/.anchor/settings.json` + `.anchor/workspace-state.json`) / Claude inbox subprocess / integrated terminal PTY sessions and terminal screen model.
- React handles **only** BlockNote / command palette / neighborhood / gesture worker / AudioWorklet. No business logic.
- Node sidecar holds the local MCP server + marketplace (Phase 3+).
- Python sidecar holds Whisper only (Phase 4). HWPX is delegated to the user's `hwpx` Claude Code skill — not rewritten.

## Roadmap

Each phase is defined in **outcomes the user actually exercises**. No phase exists just to grow infrastructure. The entry gate for each phase is the verification of the previous one.

### Phase 1B remaining (week 4–6)

**Outcome**: anchor is a first-class editor capable of carrying one project's meeting notes through a full week.

- [x] **BlockNote rich editor + raw + preview 3-way toggle** — `RichMarkdownEditor` wraps `@blocknote/mantine`; frontmatter line is preserved across rich↔source by splitting on the leading `---…---\n` block before parsing. Source tab is the textarea (with Korean IME-aware `[[` autocomplete). Preview tab is `marked` + DOMPurify. Round-trip on real notes still needs the Phase 1A verification pass.
- [x] **Single-window multi-tab editor** — shared editor tabs persist their workspace path and private/public visibility, with `EditorTab` discriminator, latest-wins selection, ⌘1..⌘8 select, ⌘W close. Closing a dirty tab stashes the draft into the existing Phase 1A `discardedEdit` toast.
- [x] **Workspace cache** — lightweight JSON cache at `<workspace>/.anchor/cache/workspace-index-v1.json`. Startup reads the disposable cache first, restores only the active tab before first paint, then runs the authoritative workspace scan in the background. Files tree scanning is lazy so it does not compete with cached document paint. Full scans also precompute version names once and reuse compiled regexes.
- [ ] **Monorepo extraction** — `crates/anchor-workspace`, `crates/anchor-git`. Done at the seam between Phase 1B and Phase 2.
- [x] **Playwright smoke + e2e** — browser smoke covers sample workspace boot, multi-tab open, source tab, and preview tab. Broader inbox/native Tauri e2e still belongs to Phase 2 verification.

**Verification gate**: a full week of multi-tab work with project + meeting + people open simultaneously, daily commits, frontmatter preserved.

### Phase 2 — Inbox + AI (week 7–10)

**Outcome**: a "Today's inbox" view that ingests local configured drop files (`inbox/drop/<channel>/`), pending item manifests, legacy `inbox/downloads/` files, and Gmail unread metadata. Claude classifies and proposes actions; the user accepts with `a` or starts `inbox-process <channel>` with `p`.

**Shipped read-only surface**:

1. **Workspace polling scan (✓ shipped)** — `scan_inbox_entries(work_path)` reads `workspace.config.yaml` `inbox:` runtime config, scans configured `channels[*].drop_paths` and `paths.pending`, and returns `InboxEntry[]` for `dropFile` and `pendingItem` rows. `scan_inbox_drop(vault_path)` still walks legacy `<workspace>/inbox/downloads/{*}/...` and returns `InboxDropItem[]`.
2. **Filesystem watcher (✓ shipped)** — `notify` watches all configured channel drop paths plus the pending path, falling back to legacy `inbox/downloads/`, and emits `inbox://file_event`; the frontend treats events as hints to re-run the cheap polling scan.
3. **Korean NL date parser (✓ shipped)** — pure Rust parser for phrases such as "내일", "다음 주 금요일", "3월 15일", and "오늘 오후 3시".
4. **Claude Code CLI subprocess bridge (✓ shipped)** — `start_claude_cli_invocation(prompt, cwd?, extra_args?)` spawns `claude -p --permission-mode plan` and streams `ai://output`, `ai://done`, and `ai://error`.
5. **Inbox classifier (✓ shipped)** — `build_inbox_classification_prompt(item)` + `parse_inbox_classification(raw)` with a closed category set (`task`/`reference`/`meeting`/`admin`/`noise`) and tolerant JSON parsing.
6. **Gmail via `gws` CLI (✓ shipped)** — Anchor shells out to `gws gmail +triage --format json` and exposes `fetch_gmail_unread(max?, query?) -> GmailMessage[]`.
7. **Inbox UI (✓ shipped)** — `InboxPane` shows Configured Entries / Processing / Processed Items / Files / Gmail sections, supports process/classify/accept/reject button actions, shows live `inbox-process` mission log tails, and uses the Files section as a local file drop target.
8. **Settings-integrated inbox runtime (✓ shipped)** — Settings → Inbox Channels edits `workspace.config.yaml` `inbox.root`, `inbox.paths`, `inbox.naming`, `inbox.file_drop`, Gmail scan settings, and channels without rewriting unrelated top-level config. `.anchor/inbox.json` is a read-only legacy fallback. Dot folders are excluded from Inbox/Files/Vault scans by default and can be included only through the Settings allowlist.
9. **Approved write loop (✓ shipped)** — all new destructive inbox decisions require a Rust-backed approval id. File accept moves to the classifier folder or user-selected folder; file reject moves to the sibling rejected store. Gmail accept applies `anchor-accepted` and removes `INBOX`; Gmail reject applies `anchor-rejected` without archiving.
10. **Keyboard + bulk loop (✓ shipped)** — Inbox supports focused rows, `⌘I`, `↑`/`↓`, `a`, `r`, `p`, `?`, checkboxes, shift range, cmd-toggle, and a bulk action footer.
11. **AI mission lifecycle (✓ shipped)** — Claude and background skill runs mirror mission state to `~/.anchor/state/missions/`, emit idle/update events, preserve optional origin metadata such as `inboxProcess`, expose log-tail reads, and expose a stop command with SIGTERM → SIGKILL escalation.
12. **Processed item history (✓ shipped)** — `scan_inbox_processed_items` reads `items/done`, `items/failed`, and `items/duplicate` using configured `inbox.paths` and `inbox.naming`; detail reads expose Summary / Route / Manifest / Extracted tabs with extracted text capped for large files.
13. **Browser smoke e2e (✓ shipped)** — Playwright verifies sample workspace boot, multi-tab editor open, source tab, and preview tab.

**Tree + Cursor shell + integrated terminal add-on (✓ shipped)**:

1. **Documents / Files Explorer** — the Explorer pane has a top Documents/Files switch. Documents keeps list/tree mode, folder-first sorting, default-collapsed folders, search/type-filter auto-expansion, per-visibility user-expanded folders, collapse/expand-all, and a Reveal in Finder context menu for files/folders. Files always uses a VS Code-style tree with workspace-safe scanning, `.anchorignore`, All/Git tracked/Binary filters, search, collapse/expand, multi-select, path copy, reveal, and add-to-queue actions. Binary mode shows only files matching the workspace setting's include patterns by default.
2. **Layered settings** — `~/.anchor/settings.json` carries user/global UI defaults, theme/accent, panel/window/split layout state, terminal defaults, launcher preferences, Explorer display defaults, file-queue defaults, and AI defaults. `<workspace>/.anchor/workspace-state.json` carries workspace-only state and overrides such as collapsed document/file folders, initialization flags, Binary include patterns, inbox channel overrides, and connector overrides. Existing `<workspace>/.anchor/settings.json` is read as a legacy migration source only and is not created for new workspaces. `.anchor/mcp.json` and `.anchor/skills.json` remain their own SSOT files.
3. **Cursor-style shell** — the main app uses a left activity rail for Docs / Inbox / Settings, a single tabbed Explorer pane, central editor tabs, and a collapsible bottom terminal panel.
4. **Split panes and tab controls** — `⌘D` splits the active document pane to the right by reusing the same draft buffer, and splits the terminal by starting a fresh PTY with the same launcher profile. The document tab row can close all clean tabs while preserving dirty drafts.
5. **Right utility pane** — the right pane now has a right-edge icon rail for Outline / Files / Memo / Skills / Guideline / Evidence / Info. Files is an operation queue: selections from the Files Explorer or external files are staged with copy/move, destination folder, conflict name/status, and an explicit Apply/Clear loop. Memos default to `.anchor/memos/`, support plain text or markdown, expose a memo list, and can be saved elsewhere via Save As.
6. **Integrated terminal** — `portable-pty` sessions feed an `alacritty_terminal` Rust model, which emits `terminal://frame` snapshots for the React grid renderer; `terminal://output` remains a compatibility stream for one migration window, and `terminal://exit` reports process state. Launcher buttons start `claude`, `codex --cd <cwd>`, or the user's shell in independent PTY tabs; closing a tab kills its PTY process. First run keeps the terminal panel collapsed; later launches restore the previous panel height/open/maximized state and auto-start Shell only when the panel is open with no tabs.
7. **Native menu bar** — the native app menu exposes File, Edit, View, Go, Terminal, Workspace, and Help commands. Menu commands reuse the same application command handlers as keyboard and command-palette actions.
8. **Auto-updater** — signed GitHub Release updater artifacts are checked at startup and installed automatically when newer than the current app version. The native app menu also exposes `Check for Updates...` for an explicit check.
9. **Settings window** — Settings opens in a separate Tauri window and edits Explorer default mode, Files default filter, file-queue default operation, document browser mode, document label mode, theme mode, accent color, terminal auto-launch, structured Inbox Channels, and raw JSON surfaces for AI, connectors, MCP, projects, and skills.

**Remaining Phase 2 hardening**:

1. **Native Tauri e2e** — cover watcher events, approved file moves, Gmail CLI failure taxonomy, Claude CLI success/failure, and mission stop.
2. **Real-workspace smoke** — configured channel drop file + pending manifest + legacy dropped file + Gmail item + Claude classification + `a`/`r`/`p` loop in one native session.
3. **KakaoTalk macOS notification watcher (optional)** — still deferred while the full-disk-access prompt is avoidable.

**AI / terminal dispatch**:
- Inbox classification: Claude Code CLI subprocess through `start_claude_cli_invocation`, streamed with the existing `ai://*` events.
- General Claude/Codex use: integrated terminal PTY tabs, using each CLI's own auth, sandbox, and approval policy.
- Future API fallback: Anthropic/OpenAI settings can be added in the Settings window once there is a write/apply workflow that needs it.

**Skip in Phase 2**: iMessage DB, Slack, Outlook (Phase 3 wraps Outlook via the `ms-office` skill).

**Verification gate**: a real unread mail item or configured dropped file arrives -> Anchor classifies or starts `inbox-process <channel>` within 30 seconds -> user presses `a` or `p` -> item is moved, labelled, or handed to the background skill without leaving the inbox session.

### Phase 3 — Built-in Skills + Hub Connector (week 11–14)

**Outcome**: daily skill-backed ops move out of the terminal into Anchor, and Anchor can query a separate hub service for shared context without becoming a multi-user server.

**Agent OS-lite implementation track**:
- Anchor-owned run contracts now wrap the imported Agent OS ideas instead of copying external contracts verbatim: `AgentRunRequest`, `AgentRunEvent`, `SkillProposal`, `ProviderAdapter`, and `ProtectedWriteClaim`.
- Background skill dispatch creates an `AgentRunRequest`, uses a provider adapter seam for Claude/Codex CLI, and writes append-only events to `<workspace>/.anchor/runs/skills/<invocationId>/events.jsonl`.
- Background execution remains proposal-first. If provider output contains an `anchor_skill_proposal_v1` JSON proposal, Anchor records `proposal.created`; applying that proposal is a separate approval-gated `agent.proposal.apply` action.
- Skill manifests/frontmatter are validated during registry scans. Invalid skills stay visible in the catalog but install and dispatch fail closed until the registry is clean.
- Protected writes require operation, actor, reason, schema version, and current-hash matching. Autonomous writes are not default behavior.
- The first 5-role loop contract is bounded: `lead -> planner -> worker -> reviewer`, optional `advisor` for ambiguity/high-risk, and one rework attempt before user-visible failure.

**Skills SSOT control-plane track**:
- Rust `src-tauri/src/skill_host/` is the canonical skills implementation. The standalone CLI (`anchor doctor`, `anchor skills ...`) reuses the same Rust command functions that Tauri calls; Node MCP remains focused on MCP tools.
- `SkillRecord.tier` is one of `core`, `public`, `private`, `imported`, or `managed`. Bundled repo skills are placement-compatible `core`; `public` and `private` become valid only under `~/.anchor/skills/_sources/skills-public` and `~/.anchor/skills/_sources/skills-private`.
- Doctor validation emits explicit `duplicate_source` and `tier_misplaced` issues, marks affected records invalid, and blocks install/dispatch for invalid records.
- Dirty/reconcile flows are tier-aware: git-backed sources can accept by add/commit/push or discard by restoring the skill path; bundled skills refuse accept and discard by rematerializing the embedded bundle; managed/imported skills accept by updating the saved hash.
- External skills become Anchor-managed only through `anchor skills import`, which writes `anchor-imported` state at `~/.anchor/skills/_imported/skills/<name>` and creates the runtime entrypoint at `~/.anchor/skills/<name>`. `anchor skills import-unmanage` removes registry/link state and can optionally delete imported files.
- Operator docs: `docs/SSOT-TIERS.md` defines tier ownership, and `docs/anchor-doctor.md` defines doctor issue codes and reconcile behavior.

**Provider abstraction track**:
- `ProviderAdapter` is now the internal boundary. V1 adapters are Claude CLI and Codex CLI wrappers; both are proposal-only and use the tools' native auth.
- Future OpenAI/Anthropic API adapters must validate `anchor_completion_request_v1` / `anchor_completion_response_v1` and store credentials only in OS keychain or a user-managed secret store.

**Local MCP + marketplace track**:
- `sidecars/anchor-mcp/` provides a dependency-light stdio MCP server. Initial tools are read-first: `workspace.search`, `document.read`, `skill.list`, `run.status`, `proposal.read`; the only write-shaped tool is `proposal.create`, which appends a proposal event and never edits workspace files.
- Marketplace manifests are validated as signed, version-pinned `anchor_marketplace_source_v1` metadata before they can sit on top of `~/.anchor/skills`.

**Cloud dashboard track**:
- Dashboard export starts from local event replay. `agent_export_redacted_run_summary` emits redacted run metadata for opt-in sync: run history, proposal/write counts, provider IDs, and skill IDs.
- Raw prompts, file bodies, credentials, and private paths are excluded from dashboard export payloads.

**Autonomous write track**:
- Stage 1 allows autonomous writes only in disposable run workspaces.
- Stage 2 allows real workspace writes only through `ProtectedWriteClaim` with current hash checks and explicit approval policy.
- Stage 3 can add user-defined low-risk session auto-approval. Every write path records `write.claimed`, `write.committed`, or `write.conflict`.

The `runtime: claude-code` lane is the v1 core — the user's `~/.claude/skills/*` are invoked as-is. **Zero lines rewritten**.

Built-in skill assets live in the repo root `skills/` directory. The bundle is
embedded into the Tauri binary and materialized into `~/.anchor/skills/_builtin`
at runtime; `skills/envs/default/setup.sh` is the bootstrap source for
`~/.anchor/env`. Shared slide design catalogs live at
`skills/docs/slide-decks/` and are also embedded with the bundle. The external
`stai-public` source is not auto-created.

**Slide deck catalog prep**:
- V1 only bundles the shared style catalog and fixes its Anchor-local SSOT path.
- Future Slides work should let the user choose a draft document or free prompt,
  choose a design deck from `skills/docs/slide-decks`, then generate a slide
  presentation using that selected design system.
- The future feature should reuse the catalog rather than duplicating prompts
  into individual skills or workspace documents.

Bundled core skill groups:
1. **Inbox / IO** — `inbox-intake`, `inbox-process`, `io-gws`, `io-kakao`, `io-mso`, `io-telegram`.
2. **Documents / decks** — `hwpx`, `pptx-toolkit`, `xlsx-toolkit`, `gpt-images-deck`, `canva-deck`, `notebooklm-deck`.
3. **Vault operations** — `vault-connect`, `vault-extract`, `vault-graph`, `vault-learn`, `vault-lint`, `vault-next`, `vault-pipeline`, `vault-refactor`, `vault-remember`, `vault-rename`, `vault-rethink`, `vault-stats`, `vault-sync`, `vault-update`.
4. **Workspace ops** — `business-unit-lifecycle`, `git-sync`, `meeting-notes`, `share-outbox`, `task-management`.
5. **Writing / analysis** — `gaejosik`, `skill-mine`.

**Verification gate**: in one day representative bundled skills run end-to-end without the terminal, with output equivalent to direct CLI execution. The user reports saving 30+ minutes.

**Anchor Hub connector**:
- `anchor-hub` is a separate private web/API service, not part of the desktop app. Anchor remains the **author SSOT** for drafting; Hub is the **published SSOT** that owns shared catalog + draft metadata index + (post-approval) the canonical markdown body, rendered artifacts, and evidence binaries.
- Anchor remains local-first. It stores global connector defaults in `~/.anchor/settings.json` and workspace connector overrides in `.anchor/workspace-state.json` or `.anchor/mcp.json`; tokens stay outside the repo in the OS keychain or a user-managed secret store.
- Two write paths from Anchor: `POST /documents/sync` (drafting metadata, Phase 4 W11) and `POST /documents/{id}/finalize` (approval-gated body + rendered artifacts + evidence binaries, Phase 6 W21).
- Deployment is private only. Demo fixtures stay synthetic and live under the Hub repo's `tests/fixtures/demo/`; production seed is separate.

**Hub connector verification gate**: a synthetic proposal note in Anchor → query hub context → pick reusable evidence → create a pending submission gate → on approval, Anchor calls finalize and the document appears in Hub's `finalized_documents` with rendered artifacts and evidence binaries attached.

### Phase 4 — Document Edit Mode (week 15–18)

**Outcome**: a dedicated mode inside anchor where voice + gesture edit a long-form proposal. The standalone `dev/anchor-editor` falls out of the loop.

**Keep** (generalized):
- Whisper sidecar (Korean large-v3) — lifted from anchor-editor.
- Intent fusion (voice command → edit intent).
- One-Euro filter + gesture worker (prev/next, scroll, accept/reject diff).
- PostToolUse → SSE diff stream (surgical edits, not chat).

**Generalize** (domain-specific -> workspace-level):
- Glossary enforcement → `.anchor/glossary.yml` per workspace.
- Templates → `.anchor/templates/` per workspace.

**Drop**: HoloBackground / R3F HUD (cute demo, no daily value). Hard-coded division/program lists. Next.js shell.

**Verification gate**: a 30-minute voice + gesture editing session produces a clean git commit with glossary violations flagged, and the user did not launch anchor-editor at all that week.

### Phase 5+ (deferred)

In likelihood order:
- **Multi-window** — lift `tolaria/src-tauri/src/window_state.rs`.
- **Conflict resolver** — when the first real merge conflict bites.
- **Public marketplace hosting** — when external user count exceeds 10.
- **Semantic search** — when keyword + relationships + git-grep are demonstrably insufficient.
- **NotebookLM bridge** — low priority.

## Open decisions (input needed)

Items requiring the user's decision before further phases proceed:

1. **Workspace cache threshold** — shipped as a lightweight JSON index because `~/workspace/work` startup latency is dominated by the full initial pipeline, not only the Rust scan. Keep measuring cold scan and warm cache paint before lifting to a heavier database cache.
2. **BlockNote ↔ raw default** — rich for general notes; raw for precision-sensitive editing such as proposals and reports. Per-workspace setting vs per-doc setting?
3. **Multi-tab UX** — close-with-dirty confirmation: Obsidian pattern (autosave) vs VS Code pattern (confirm)?
4. **Unresolved-wikilink behavior** — Phase 1A surfaces a soft notice. Phase 1B should pick: (a) red underline + create-new dialog, or (b) auto-stub note then open it.
5. **anchor MCP port** — 9710 (matches tolaria) or fall back to 9712/9713?
6. **anchor-editor archive timing** — archive immediately after the Phase 4 verification gate, or keep around for six months as reference?
7. **AI fallback API key storage** — Tauri stronghold plugin (macOS Keychain) is the recommendation; confirm operational fit.
8. **History shortcuts (lock-in)** — ⌘[ back / ⌘] forward (no browser conflict). Already shipped in Phase 1A; lock unless changing.

## Hard "No" list (v1)

Out of scope for v1 by explicit decision:

- Semantic / embedding search (keyword + wikilink + git-grep cover 10k notes).
- Cloud sync, anchor account, default telemetry (opt-in only).
- Mobile (Tauri 2 mobile is unstable; Obsidian owns mobile for now).
- Public marketplace server (no moderation policy).
- iMessage / Slack ingestion (permission pain > value).
- NotebookLM, podcast, slide export.
- Multi-user collab, CRDT, realtime (single user, single device, git for history).
- PDF annotation, OCR (file-extracted text is enough).
- Agent-autonomous edits as default behavior. Autonomy is staged behind disposable workspaces, protected writes, approval policy, and audit events.
- iCloud / Dropbox workspace awareness (user's responsibility).
- Unsigned / ad-hoc auto-updater feeds (updates are accepted only through signed GitHub Release artifacts).

## Development

```bash
pnpm install

# Browser dev (mocked Tauri):
pnpm dev

# Native Tauri dev (cleans stale local app bundles first):
pnpm tauri:dev

# Type check:
pnpm typecheck

# Production build:
pnpm build

# Signed native release build:
make tauri-build

# Raw pnpm build still requires explicit updater signing env:
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/anchor-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/anchor-updater.key.password)"
pnpm tauri:build

# If you need the raw Tauri CLI, clean stale local bundles first:
pnpm clean:tauri-bundles
pnpm tauri build

# Rust unit + integration tests:
cd src-tauri && cargo test

# Local Anchor MCP sidecar smoke:
ANCHOR_MCP_WORKSPACE="$PWD" node sidecars/anchor-mcp/index.mjs

# Skills registry doctor / reconcile:
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- --version
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- doctor --quiet
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- doctor --json
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- skills dirty --json
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- skills reconcile <name-or-id> --accept --dry-run
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- skills reconcile <name-or-id> --discard
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- skills import /path/to/skill --copy
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- skills import /path/to/skill --link
cargo run --manifest-path src-tauri/Cargo.toml --bin anchor-cli -- skills import-unmanage <name> --delete-files

# Bench workspace scan on a real workspace:
cd src-tauri && cargo test --release bench_scan_real_workspace \
    -- --ignored --nocapture --test-threads=1
# → ANCHOR_BENCH_WORKSPACE=/some/path overrides the default ~/workspace/work

# Cold/warm startup expectation:
# 1. first scan creates <workspace>/.anchor/cache/workspace-index-v1.json
# 2. next app load renders cached entries + active document before the
#    background scan refreshes the index
# 3. Files tree scanning waits until the Files pane is visible, so it does
#    not compete with cached document paint on warm startup
```

## Release Bundles

Publishing a GitHub Release triggers `.github/workflows/release-bundles.yml`.
The workflow builds native Tauri bundles on macOS, Ubuntu, and Windows, then
uploads the generated `.app` / `.dmg`, `.deb` / `.rpm` / `.AppImage`, `.exe`,
and `.msi` assets to that same release. It also uploads signed updater
metadata consumed by the startup auto-updater and native `Check for Updates...`
menu action. A separate macOS CLI job builds `anchor-cli`, packages it as a
tarball containing an `anchor` executable, and uploads
`anchor-cli_<version>_darwin_{aarch64,x86_64}.tar.gz` plus SHA256 files to the
same release.

macOS bundles must be code signed before publishing. Until Apple Developer ID
secrets are configured, Anchor uses explicit ad-hoc bundle signing
(`bundle.macOS.signingIdentity = "-"`) so Apple Silicon downloads are not
shipped as unsigned/broken app bundles. For fully trusted Gatekeeper launches,
configure these GitHub Secrets and publish a new release:

- `APPLE_CERTIFICATE` — base64 encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_API_ISSUER_ID`
- `APPLE_API_KEY_ID`
- `APPLE_API_KEY` — base64 encoded App Store Connect API `.p8`

The release workflow imports `APPLE_CERTIFICATE` only inside the macOS signing
prep step, and it sends Apple notarization env vars only to the Developer ID
build branch. It intentionally does not pass unset Apple secrets into
`tauri-apps/tauri-action`, because empty environment variables make Tauri try
to import or notarize with blank credentials.

Minimum Apple Developer setup for direct distribution:

1. In Apple Developer `Certificates, Identifiers & Profiles`, create only a
   `Developer ID Application` certificate. Anchor does not need an Identifier
   or Provisioning Profile for the current direct-distribution path because it
   does not use iCloud, Push Notifications, App Groups, or another advanced
   entitlement that requires a Developer ID provisioning profile.
2. Install the downloaded `.cer` into Keychain Access, then export it with its
   private key as a password-protected `.p12`.
3. Encode the `.p12` and set the release secrets:

   ```bash
   tmp_cert_b64="$(mktemp)"
   openssl base64 -A -in DeveloperIDApplication.p12 -out "$tmp_cert_b64"
   gh secret set APPLE_CERTIFICATE --repo STAIxBWLB/anchor --body-file "$tmp_cert_b64"
   rm "$tmp_cert_b64"

   gh secret set APPLE_CERTIFICATE_PASSWORD --repo STAIxBWLB/anchor
   gh secret set KEYCHAIN_PASSWORD --repo STAIxBWLB/anchor
   gh secret set APPLE_API_ISSUER_ID --repo STAIxBWLB/anchor
   gh secret set APPLE_API_KEY_ID --repo STAIxBWLB/anchor
   gh secret set APPLE_API_KEY --repo STAIxBWLB/anchor
   ```

4. Confirm release readiness without printing secret values:

   ```bash
   make macos-distribution-check
   make macos-distribution-local-check
   ```

For a local notarization smoke test, keep Apple files under
`~/workspace/work/.secrets/apple/`:

- `DeveloperIDApplication.p12`
- `AuthKey_<APPLE_API_KEY_ID>.p8`
- `certificate-password`
- `api-issuer-id`
- optional `api-key-id` (defaults to the `AuthKey_<id>.p8` filename)
- optional `keychain-password` (generated locally if missing)

Then run:

```bash
make macos-notarize-local TARGET=aarch64-apple-darwin
```

Keep the Tauri updater secrets (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in place; they sign updater metadata and
are separate from Apple Developer ID signing. The workflow now fails on partial
Apple signing configuration instead of silently producing an unintended ad-hoc
macOS release.

Release asset versions come from the app metadata in `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`; keep those in sync
before tagging or publishing a release. After release assets exist, update the
Homebrew tap with:

```bash
make homebrew-update-commit RELEASE_TAG=v0.2.12 HOMEBREW_TAP_DIR=../homebrew-cask
make homebrew-audit HOMEBREW_TAP_DIR=../homebrew-cask
make homebrew-fetch HOMEBREW_TAP_DIR=../homebrew-cask
```

After downloading the release DMG, verify Gatekeeper-facing state on macOS:

```bash
xcrun stapler validate Anchor_*.dmg
spctl -a -vv -t open --context context:primary-signature Anchor_*.dmg
codesign --verify --deep --strict --verbose=4 /Applications/Anchor.app
spctl -a -vv -t exec /Applications/Anchor.app
```

## Workspace Layout

An AI workspace is any folder containing `.md` (or `.markdown`, `.html`, `.htm`) files.

Private workspace is the required default. Public workspace is optional and means a provider-managed shared root, not internet publishing. V1 capability support is registry-only: Anchor stores non-secret provider metadata in `workspaces.json`, maps a manually entered provider role to coarse capabilities, intersects that with a filesystem writability probe, and gates direct writes in the UI and Rust commands. OAuth, Microsoft Graph, Google Drive, and Nextcloud live API checks are deferred.

Supported public providers are Local, Google Drive, OneDrive, SharePoint, Nextcloud, Obsidian, and Unknown. `workspace.config.yaml` accepts:

```yaml
paths:
  private: ~/workspace/work
  public:
    - label: Team Drive
      path: ~/gdrive-workspace/work
      provider: googleDrive
      providerId: shared-drive-id
      writePolicy: direct
      role: contentManager
    - label: Reference Site
      path: ~/shared/reference
      provider: sharePoint
      writePolicy: readOnly
      role: Can view
```

Anchor stores user/global preferences at:

```
~/.anchor/
  settings.json    # UI/theme/layout/window/split/terminal/explorer/file-queue/AI defaults
```

Anchor stores workspace-local state and resources at:

```
<workspace>/
  .anchor/
    cache/           # disposable workspace index for warm startup
    workspace-state.json # collapsed folders, initialization flags, binary patterns, overrides
    versions/        # snapshots created via the "Version" button
  .anchorignore      # optional, gitignore-style segment patterns
```

`<workspace>/.anchor/settings.json` is a legacy migration input only. Anchor reads it when present to build effective settings, but new workspaces do not get that file.

`.anchorignore` example for the user's `~/workspace/work`:

```
node_modules
.venv
dist
build
_sys/env
target
.next
.turbo
.cache
.anchor/cache
```

## Critical invariants

1. **Filesystem is authoritative.** The cache (`<workspace>/.anchor/cache/workspace-index-v1.json`) is disposable. React state is derived.
2. **Frontmatter key order + comments preserved.** A single-field patch must never disturb the order or comments of any other key (verified by cargo test).
3. **Crash-safe rename.** `.anchor-rename-txn/` staging dir + recovery on the next workspace scan (Phase 1B).
4. **Dynamic relationship detection.** Any frontmatter field containing `[[wikilink]]` is treated as a relationship. No hard-coded field lists.
5. **Symlinks inside the workspace are honored.** Deliberate user-created symlinks (e.g. `~/workspace/work/inbox/downloads → ~/gdrive-workspace/...`) are considered part of the workspace. Anchor uses lexical containment, not `canonicalize()`.

## License

No license file is currently published. All rights reserved unless a license is added.
