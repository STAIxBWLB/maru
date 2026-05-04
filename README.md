# AI Workspace

AI workspace desktop app. Tauri 2 + Rust + React 19 + TypeScript.

## Status (2026-05-04)

| Phase | State | Outcome |
|-------|-------|---------|
| 0 — Hardening | ✅ shipped | Open existing workspaces safely. Frontmatter byte-identical round-trip. Multi-workspace registry. ko/en parity. |
| 0.5 — UI polish | ✅ shipped | Topbar, sidebar with type filters + recents, command palette (⌘K), Pretendard Korean typography, light/dark. |
| 1A — Killer feature MVP | ✅ shipped | Doc-selection reliability, frontmatter inline edit (InspectorPane), wikilink autocomplete (Korean IME-aware) + click-to-navigate, typed neighborhood pane (project / mentions / peers), in-memory nav history (⌘[ / ⌘]). |
| 1B — Rich editor / git | ✅ feature-complete | Git status badge + commit-from-app (file list + per-file diff + syntax color + auto-refresh on focus). Workspace scan rayon parallelism plus cache-backed warm startup for `~/workspace/work`: cached entries + active document render first, then authoritative scan reconciles in the background. Multi-tab editor (per-workspace persistence, ⌘1..⌘8 select, ⌘W close, dirty stash). BlockNote rich + source + preview 3-way toggle (frontmatter line preserved). Browser smoke e2e is in place. **Deferred**: monorepo extraction. |
| 2 — Inbox + AI | 🚧 read-only surface live | Backend (polling, watcher, date parser, Claude CLI bridge, classifier, Gmail via `gws` CLI) + UI (`InboxPane` with parallel Files / Gmail sections, classify/accept/reject) all shipped. Accept/reject currently updates UI state only; file-move on accept + Gmail label-modify/archive remain. |
| 2.5 — Tree + Cursor shell + Terminal launchers | ✅ shipped | Document browser supports list/tree mode, filename/title display mode, collapsed-by-default tree folders with persisted user state, collapse/expand-all, and Reveal in Finder. The shell now uses a Cursor-style activity rail, Explorer tabs for Private/Public workspaces, split-right document and terminal panes (`⌘D`), clean-tab close-all, a right-edge utility rail, and bottom integrated terminal with maximize/restore. Private workspace is the default write target; Public workspace is optional and selected explicitly when present. `.anchor/settings.json` stores theme/accent/layout/window size/split/terminal defaults plus future AI, inbox-channel, and connector placeholders. Claude, Codex, and Shell launch as real PTY tabs from the active workspace; first run starts with the terminal collapsed and restores the user's last layout afterward. Signed auto-update checks run at startup, and the native app menu exposes `Check for Updates...`. |
| 3 — Built-in Skills | 📋 planned | |
| 4 — Document Edit Mode | 📋 planned | |

## Next up (immediate)

Phase 2 has crossed the read-only boundary. The next work is the smallest safe write/apply loop:

1. **File accept action** — move accepted drops from `inbox/downloads/<source>/...` into the classifier's `suggestedFolder` when present; otherwise require a user-selected target. Keep all moves inside the workspace boundary.
2. **Gmail accept/reject action** — call `gws` to apply Anchor labels and archive accepted mail. Rejected mail should be labelled or left unread until the policy is chosen.
3. **Keyboard accept loop** — add focused inbox selection plus `a` / `r` actions so the button-only UI becomes the promised one-keystroke flow.
4. **Real-workspace verification** — verify dropped files, real chu.ac.kr unread mail, Claude classification, and accept/reject in one Tauri session.
5. **Phase 3 bridge prep** — the Claude inbox bridge, integrated terminal, and `.anchor/settings.json` terminal defaults are in place; next is wiring skills to the command palette with accept/reject diffs.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri Webview (src/)                                        │
│   React 19 + Radix UI + marked (preview) + DOMPurify         │
│   Phase 1B: + BlockNote rich editor + MediaPipe (Phase 4)    │
│                                                               │
│   Activity rail: Docs / Inbox / Settings                     │
│   Tabbed Explorer tree + editor + bottom integrated terminal  │
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
│   anchor_dir.rs  — .anchor settings/rules/templates/catalogs  │
│   Phase 3+: + skill_host.rs                                  │
│   Phase 4+: + whisper bridge / mcp lifecycle                 │
└──────┬─────────────────────────────────────────────────────┘
       │ stdio bridge + future WS/MCP bridges
┌──────▼────────┐ ┌────────────────────┐ ┌──────────────────┐
│ MCP server    │ │ User's Claude Code │ │ Whisper sidecar  │
│ (Node, Phase 3)│ │ CLI (~/.claude/skills/*)│ │ (Python, Phase 4)│
└───────────────┘ └────────────────────┘ └──────────────────┘
```

**Module boundary rules**:
- Rust core **owns** workspace FS / cache / git / frontmatter / inbox scan/watch/classification / Gmail `gws` bridge / `.anchor/settings.json` / Claude inbox subprocess / integrated terminal PTY sessions.
- React handles **only** BlockNote / command palette / neighborhood / gesture worker / AudioWorklet. No business logic.
- Node sidecar holds the MCP server + marketplace (Phase 3+).
- Python sidecar holds Whisper only (Phase 4). HWPX is delegated to the user's `hwpx` Claude Code skill — not rewritten.

## Roadmap

Each phase is defined in **outcomes the user actually exercises**. No phase exists just to grow infrastructure. The entry gate for each phase is the verification of the previous one.

### Phase 1B remaining (week 4–6)

**Outcome**: anchor is a first-class editor capable of carrying one project's meeting notes through a full week.

- [x] **BlockNote rich editor + raw + preview 3-way toggle** — `RichMarkdownEditor` wraps `@blocknote/mantine`; frontmatter line is preserved across rich↔source by splitting on the leading `---…---\n` block before parsing. Source tab is the textarea (with Korean IME-aware `[[` autocomplete). Preview tab is `marked` + DOMPurify. Round-trip on real notes still needs the Phase 1A verification pass.
- [x] **Single-window multi-tab editor** — shared editor tabs persist their workspace path and private/public visibility, with `EditorTab` discriminator, latest-wins selection, ⌘1..⌘8 select, ⌘W close. Closing a dirty tab stashes the draft into the existing Phase 1A `discardedEdit` toast.
- [x] **Workspace cache** — lightweight JSON cache at `<workspace>/.anchor/cache/workspace-index-v1.json`. Startup reads the disposable cache first, restores only the active tab before first paint, then runs the authoritative workspace scan in the background. Full scans also precompute version names once and reuse compiled regexes.
- [ ] **Monorepo extraction** — `crates/anchor-workspace`, `crates/anchor-git`. Done at the seam between Phase 1B and Phase 2.
- [x] **Playwright smoke + e2e** — browser smoke covers sample workspace boot, multi-tab open, source tab, and preview tab. Broader inbox/native Tauri e2e still belongs to Phase 2 verification.

**Verification gate**: a full week of multi-tab work with project + meeting + people open simultaneously, daily commits, frontmatter preserved.

### Phase 2 — Inbox + AI (week 7–10)

**Outcome**: a "Today's inbox" view that ingests Gmail and dropped files (`inbox/downloads/`), Claude classifies and proposes actions, the user accepts with a single `a` keystroke.

**Shipped read-only surface**:

1. **Workspace polling scan (✓ shipped)** — `scan_inbox_drop(vault_path)` walks `<workspace>/inbox/downloads/{*}/...` and returns `InboxDropItem[]` (id, source, size, mtime). The Rust command keeps its legacy argument name for compatibility.
2. **Filesystem watcher (✓ shipped)** — `notify` watches `<workspace>/inbox/downloads/` and emits `inbox://file_event`; the frontend treats events as hints to re-run the cheap polling scan.
3. **Korean NL date parser (✓ shipped)** — pure Rust parser for phrases such as "내일", "다음 주 금요일", "3월 15일", and "오늘 오후 3시".
4. **Claude Code CLI subprocess bridge (✓ shipped)** — `start_claude_cli_invocation(prompt, cwd?, extra_args?)` spawns `claude -p --permission-mode plan` and streams `ai://output`, `ai://done`, and `ai://error`.
5. **Inbox classifier (✓ shipped)** — `build_inbox_classification_prompt(item)` + `parse_inbox_classification(raw)` with a closed category set (`task`/`reference`/`meeting`/`admin`/`noise`) and tolerant JSON parsing.
6. **Gmail via `gws` CLI (✓ shipped)** — Anchor shells out to `gws gmail +triage --format json` and exposes `fetch_gmail_unread(max?, query?) -> GmailMessage[]`.
7. **Inbox UI (✓ shipped)** — `InboxPane` shows parallel Files / Gmail sections and supports classify/accept/reject button actions.
8. **Browser smoke e2e (✓ shipped)** — Playwright verifies sample workspace boot, multi-tab editor open, source tab, and preview tab.

**Tree + Cursor shell + integrated terminal add-on (✓ shipped)**:

1. **Document tree** — the document browser has list/tree mode, folder-first sorting, collapsed-by-default folders on first run, search/type-filter auto-expansion, per-visibility collapsed folders, collapse/expand-all, and a Reveal in Finder context menu for files/folders.
2. **Workspace settings** — `.anchor/settings.json` carries UI defaults, theme/accent, panel/window layout state, terminal defaults, launcher preferences, and placeholders for AI providers, inbox channels, and connectors. `.anchor/mcp.json` and `.anchor/skills.json` remain their own SSOT files.
3. **Cursor-style shell** — the main app uses a left activity rail for Docs / Inbox / Settings, a single tabbed Explorer pane, central editor tabs, and a collapsible bottom terminal panel.
4. **Split panes and tab controls** — `⌘D` splits the active document pane to the right by reusing the same draft buffer, and splits the terminal by starting a fresh PTY with the same launcher profile. The document tab row can close all clean tabs while preserving dirty drafts.
5. **Right utility pane** — the right pane now has a right-edge icon rail for Outline / Files / Memo / Info. Files default to `.anchor/stash/files/` with copy/move support and can be saved elsewhere via Save As. Memos default to `.anchor/memos/`, support plain text or markdown, expose a memo list, and can be saved elsewhere via Save As.
6. **Integrated terminal** — `portable-pty` sessions stream through `terminal://output` and `terminal://exit`. Launcher buttons start `claude`, `codex --cd <cwd>`, or the user's shell in independent xterm tabs; closing a tab kills its PTY process. First run keeps the terminal panel collapsed; later launches restore the previous panel height/open/maximized state and auto-start Shell only when the panel is open with no tabs.
7. **Auto-updater** — signed GitHub Release updater artifacts are checked at startup and installed automatically when newer than the current app version. The native app menu also exposes `Check for Updates...` for an explicit check.
8. **Settings window** — Settings opens in a separate Tauri window and edits document browser mode, document label mode, theme mode, accent color, terminal auto-launch, and raw JSON surfaces for AI, inbox channels, connectors, MCP, projects, and skills.

**Remaining write/apply work**:

1. **File accept** — move or route accepted files after user confirmation; reject must avoid destructive deletes.
2. **Gmail accept/reject** — apply labels/archive through `gws`; keep raw mail bodies out of logs and fixtures.
3. **One-keystroke loop** — focused row selection, `a` accept, `r` reject, and visible pending counts.
4. **Native Tauri e2e** — cover watcher events, Claude CLI success/failure, and Gmail CLI failure taxonomy.
5. **KakaoTalk macOS notification watcher (optional)** — still deferred while the full-disk-access prompt is avoidable.

**AI / terminal dispatch**:
- Inbox classification: Claude Code CLI subprocess through `start_claude_cli_invocation`, streamed with the existing `ai://*` events.
- General Claude/Codex use: integrated terminal PTY tabs, using each CLI's own auth, sandbox, and approval policy.
- Future API fallback: Anthropic/OpenAI settings can be added in the Settings window once there is a write/apply workflow that needs it.

**Skip in Phase 2**: iMessage DB, Slack, Outlook (Phase 3 wraps Outlook via the `ms-office` skill).

**Verification gate**: a real chu.ac.kr admin email or dropped file arrives → anchor classifies, extracts a task/date, and proposes a folder within 30 seconds → user presses `a` → item is moved/labelled without leaving the inbox session.

### Phase 3 — Built-in Skills (week 11–14)

**Outcome**: five daily ops moved out of the terminal into the command palette.

The `runtime: claude-code` lane is the v1 core — the user's `~/.claude/skills/*` are invoked as-is. **Zero lines rewritten**.

Five skills:
1. **inbox-processor** — pick an inbox item → palette → run skill → show diff → stage.
2. **meeting-notes** — palette → emit `meetings/YYMMDD-*.md` template (Phase 4 adds voice).
3. **task-management** — analyze `_inbox/` → sync `TASKS.md`.
4. **lint** — run `/lint` → inline report (read-only; no auto-fix).
5. **hwpx-fill** — pick template → fill fields → emit `.hwpx`.

**Verification gate**: in one day all five run end-to-end without the terminal, with output equivalent to direct CLI execution. The user reports saving 30+ minutes.

### Phase 4 — Document Edit Mode (week 15–18)

**Outcome**: a dedicated mode inside anchor where voice + gesture edit the RISE proposal. The standalone `dev/anchor-editor` falls out of the loop.

**Keep** (generalized):
- Whisper sidecar (Korean large-v3) — lifted from anchor-editor.
- Intent fusion (voice command → edit intent).
- One-Euro filter + gesture worker (prev/next, scroll, accept/reject diff).
- PostToolUse → SSE diff stream (surgical edits, not chat).

**Generalize** (RISE-specific → workspace-level):
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
2. **BlockNote ↔ raw default** — rich for general notes; raw for precision-sensitive editing such as the RISE proposal. Per-workspace setting vs per-doc setting?
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
- Agent-autonomous edits (every Claude write goes through accept/reject diff).
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

# Signed native release build (requires updater signing env):
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/anchor-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/anchor-updater.key.password)"
pnpm tauri:build

# If you need the raw Tauri CLI, clean stale local bundles first:
pnpm clean:tauri-bundles
pnpm tauri build

# Rust unit + integration tests:
cd src-tauri && cargo test

# Bench workspace scan on a real workspace:
cd src-tauri && cargo test --release bench_scan_real_workspace \
    -- --ignored --nocapture --test-threads=1
# → ANCHOR_BENCH_WORKSPACE=/some/path overrides the default ~/workspace/work

# Cold/warm startup expectation:
# 1. first scan creates <workspace>/.anchor/cache/workspace-index-v1.json
# 2. next app load renders cached entries + active document before the
#    background scan refreshes the index
```

## Release Bundles

Publishing a GitHub Release triggers `.github/workflows/release-bundles.yml`.
The workflow builds native Tauri bundles on macOS, Ubuntu, and Windows, then
uploads the generated `.app` / `.dmg`, `.deb` / `.rpm` / `.AppImage`, `.exe`,
and `.msi` assets to that same release. It also uploads signed updater
metadata consumed by the startup auto-updater and native `Check for Updates...`
menu action.

macOS bundles must be code signed before publishing. Until Apple Developer ID
secrets are configured, Anchor uses explicit ad-hoc bundle signing
(`bundle.macOS.signingIdentity = "-"`) so Apple Silicon downloads are not
shipped as unsigned/broken app bundles. For fully trusted Gatekeeper launches,
configure these GitHub Secrets and publish a new release:

- `APPLE_CERTIFICATE` — base64 encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD` — Apple app-specific password
- `APPLE_TEAM_ID`

The release workflow imports `APPLE_CERTIFICATE` only inside the macOS signing
prep step. It intentionally does not pass certificate secrets into
`tauri-apps/tauri-action`, because unset secrets arrive as empty environment
variables and make Tauri try to import an empty `.p12`.

Release asset versions come from the app metadata in `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`; keep those in sync
before tagging or publishing a release.

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

Anchor stores per-workspace state at:

```
<workspace>/
  .anchor/
    cache/           # disposable workspace index for warm startup
    settings.json    # anchor UI/theme/layout/window/terminal defaults
    versions/        # snapshots created via the "Version" button
  .anchorignore      # optional, gitignore-style segment patterns
```

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

UNLICENSED — internal RISE/Anchor work.
